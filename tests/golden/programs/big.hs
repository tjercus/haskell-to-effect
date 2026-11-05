module Main where

countDown :: Int -> Int
countDown 0 = 0
countDown n = 1 + countDown (n - 1)

main :: IO ()
main = do
  print (length (replicate 100000 'x'))
  print (sum (map (`mod` 7) (replicate 100000 10)))
  print (length (foldr (:) [] (replicate 100000 True)))
  print (countDown 5000)
